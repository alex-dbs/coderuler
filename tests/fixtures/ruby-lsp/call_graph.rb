require "support_widget"

class GraphFlow
  def origin
    left
    right
  end

  def left
    leaf
  end

  def right
    leaf
  end

  def leaf
  end
end

class CycleFlow
  def alpha
    beta
  end

  def beta
    gamma
  end

  def gamma
    alpha
  end
end

class RedWorker
  def run
    red_task
  end

  def red_task
  end
end

class BlueWorker
  def run
    blue_task
  end

  def blue_task
  end
end

class ReceiverEntrypoints
  def red_entry
    RedWorker.new.run
  end

  def blue_entry
    BlueWorker.new.run
  end
end

class BareCalls
  def bare_entry
    bare_target
  end

  def bare_target
  end

  def local_reader
    local_target = 1
    local_target
  end

  def local_target
  end
end

class ShapeFlow
  def self.singleton_entry
    endless_target
  end

  def self.endless_target = :done
end

class ScopeFlow
  def outer
    inner
    def nested
      nested_leaf
    end
  end

  def inner
  end

  def nested_leaf
  end
end

class BlockFlow
  def block_entry
    [1].each do
      block_leaf
    end
  end

  def block_leaf
  end
end

class SuperBase
  def save(value)
  end
end

class SuperChild < SuperBase
  def save(value)
    super
  end
end

class ForwardChild < SuperBase
  def save(value)
    super(value)
  end
end

class MaybeOne
  def shared
    self.candidate_one_leaf
  end

  def candidate_one_leaf
  end
end

class MaybeTwo
  def shared
    self.candidate_two_leaf
  end

  def candidate_two_leaf
  end
end

def ambiguous_entry(receiver)
  receiver.shared
end

class UnicodeFlow
  def unicode_entry
    "😀"; unicode_leaf
  end

  def unicode_leaf
  end
end

class DependencyEntrypoint
  def dependency_entry
    SupportWidget.new.remote_execute
  end

  def dependency_sink
  end
end

class PropertyWriteFlow
  def value
    getter_helper
  end

  def value=(replacement)
    replacement
  end

  def assignment_entry
    self.value = rhs_helper
  end

  def read_entry
    self.value
  end

  def rhs_helper
  end

  def getter_helper
  end
end

class Utf16Flow
  "😀"
  "🧪"

  def c; x; end
  def x; end
end

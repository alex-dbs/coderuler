class SupportWidget
  def remote_execute
    remote_leaf
  end

  def remote_leaf
  end

  def remote_call_project
    DependencyEntrypoint.new.dependency_sink
  end
end
